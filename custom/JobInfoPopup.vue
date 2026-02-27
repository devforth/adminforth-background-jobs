<template> 
    <div class="flex flex-col w-full min-w-96">
      <div class="flex items-center mb-1">
        <h2 class="text-lg font-semibold">{{ job.name }}</h2>
        <p class="ml-2 text-xs text-gray-600 h-full"> {{ getTimeAgoString(new Date(job.createdAt)) }}</p>
        <p class="ml-auto text-gray-800 h-full"> {{  t('Progress:')  }} <span class="font-semibold" >{{ job.progress }}%</span></p>
        <StateToIcon :job="job" />
      </div>
      <div class="flex items-center gap-4 w-full">
        <ProgressBar 
          :current-value="job.progress" 
          :max-value="100" 
          :min-value="0"
          :showAnimation="job.status === 'IN_PROGRESS'"
          :showLabels="false"
          :showValues="false"
          :show-progress="false"
          :height="6"
        />
        <Button class="h-8" v-if="job.status === 'IN_PROGRESS'" @click="cancelJob"> {{ t('Cancel') }} </Button>
      </div>
    </div>
    <component 
      v-if="job.customComponent"
      class="mt-4" 
      :is="getCustomComponent(job.customComponent)" 
      :meta="job.customComponent"
      :getJobTasks="getJobTasks"
      :job="job"
    />
</template>



<script setup lang="ts">
import type { IJob } from './utils';
import { ProgressBar, Button } from '@/afcl';
import { getTimeAgoString, callAdminForthApi, getCustomComponent} from '@/utils';
import { useI18n } from 'vue-i18n';
import StateToIcon from './StateToIcon.vue';
import { useAdminforth } from '@/adminforth';


const { t } = useI18n();

const adminforth = useAdminforth();

const props = defineProps<{
  job: IJob;
  meta: {
    pluginInstanceId: string;
  };
}>();

async function cancelJob() {
  // Implement job cancellation logic here
  const isConfirmed = await adminforth.confirm({ message: t('Are you sure you want to cancel this job?') });
  if (!isConfirmed) {
    return;
  }
  const failedToCancelText = t('Failed to cancel job');
  console.log(`Canceling job with ID: ${props.job.id}`);
  try {
    const res = await callAdminForthApi({
      path: `/plugin/${props.meta.pluginInstanceId}/cancel-job`,
      method: 'POST',
      body: {
        jobId: props.job.id,
      },
    });
    if (res.ok) {
      adminforth.alert({ message: t('Job cancelled successfully'), variant: 'success' });
    } else {
      adminforth.alert({ message: failedToCancelText, variant: 'danger' });
    }
  } catch (error) {
    adminforth.alert({ message: failedToCancelText, variant: 'danger' });
    console.error('Error canceling job:', error);
  }
}



async function getJobTasks(limit: number = 10, offset: number = 0): Promise<{state: Record<string, any>, status: string}[]> {
  try {
    const res = await callAdminForthApi({
      path: `/plugin/${props.meta.pluginInstanceId}/get-tasks`,
      method: 'POST',
      body: {
        jobId: props.job.id,
        limit,
        offset,
      },
    });
    if (res.ok) {
      return res.tasks;
    } else {
      console.error('Error fetching job tasks:', res.error);
      return [];
    }
  } catch (error) {
    console.error('Error fetching job tasks:', error);
    return [];
  }
}



</script>